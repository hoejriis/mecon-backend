#!/usr/bin/env python3
"""Mutation check for the capture safety rules and accounting.

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
    ("c5", "received counted before the commit (when the write lock is taken)", "archive.py",
     [('        with self._write_lock:\n            try:\n                self._conn.execute("BEGIN IMMEDIATE")',
       '        with self._write_lock:\n            self._received += len(captures)\n            try:\n                self._conn.execute("BEGIN IMMEDIATE")')]),
    ("c6", "the content hash has no separator", "archive.py",
     [('topic.encode("utf-8") + b"\\x00" + payload', 'topic.encode("utf-8") + payload')]),
    ("c7", "a payload exactly at the limit is stubbed", "archive.py",
     [("stub = payload is None or size > self.max_payload_bytes", "stub = payload is None or size >= self.max_payload_bytes")]),
    ("c8", "a batch may hold more than 500 captures", "archive.py",
     [("MAX_BATCH = 500", "MAX_BATCH = 5000")]),
    ("c9", "an unavailable batch is not counted", "archive.py",
     [("            self._unavailable += 1\n", "            pass\n")]),
    ("c10", "stubbed captures are not counted as committed's subset (stubbed not counted)", "archive.py",
     [("                self._stubbed += len(stubbed)", "                pass")]),
    ("c11", "a malformed capture is committed", "archive.py",
     [("                    if checked is None:\n                        rejected.append", "                    if checked is None and False:\n                        rejected.append")]),
    # ---- acceptance at the commit, stubs, the receive bound, the ingester's counters (draft.3 / draft.2) ----
    ("a1", "received not counted at all on commit", "archive.py",
     [("                self._received += len(captures)\n", "                pass\n")]),
    ("a2", "the four counters move in separate steps (received in its own step before the rest)", "archive.py",
     [("            with self._state:  # accepted at the commit: all four counted together, in one step\n                self._received += len(captures)\n",
       "            with self._state:\n                self._received += len(captures)\n            with self._state:\n")]),
    ("a3", "an arrived stub is not listed in stubbed", "archive.py",
     [("                    if stub:\n                        stubbed.append(i)", "                    if stub and payload is not None:\n                        stubbed.append(i)")]),
    ("a4", "an arrived stub is treated as an empty payload (bytes, size and hash recomputed)", "archive.py",
     [("        return None, size, h\n", "        return b\"\", 0, content_hash(topic, b\"\")\n")]),
    ("a6", "a capture with both a payload and a stub is accepted (stub wins)", "archive.py",
     [("    if not isinstance(c, dict) or set(c) not in (FULL_KEYS, STUB_KEYS):", "    if not isinstance(c, dict) or set(c) not in (FULL_KEYS, STUB_KEYS, FULL_KEYS | STUB_KEYS):")]),
    ("a7", "the archive reports a dropped count of its own (record_dropped back)", "archive.py",
     [("        self._unavailable = 0\n", "        self._unavailable = 0\n        self._dropped = 0\n"),
      ('"buffered": 0, "dropped": 0,', '"buffered": 0, "dropped": self._dropped,'),
      ("    def counters(self)", "    def record_dropped(self, n: int = 1) -> None:\n        with self._state:\n            self._received += n\n            self._dropped += n\n\n    def counters(self)")]),
    ("r1", "the receive bound is off (an oversize message is buffered whole)", "ingester.py",
     [("        oversize = len(payload) > self._max_receive", "        oversize = False")]),
    ("r2", "a payload exactly at the receive bound is a stub", "ingester.py",
     [("        oversize = len(payload) > self._max_receive", "        oversize = len(payload) >= self._max_receive")]),
    ("r3", "an oversize message is not counted oversize", "ingester.py",
     [("            if oversize:\n                self._oversize += 1", "            if False:\n                self._oversize += 1")]),
    ("r4", "the stub of an oversize message hashes the payload alone", "ingester.py",
     [("                digest = content_hash(topic, payload)", "                digest = __import__(\"hashlib\").sha256(payload).hexdigest()")]),
    ("r5", "the ingester's receive bound is taken from the archive limit, not max_receive_bytes", "ingester.py",
     [("        self._max_receive = max_receive_bytes", "        self._max_receive = 65536")]),
    ("i1", "shed captures are counted in the archive instead of the ingester", "ingester.py",
     [("        self._received = self._handed_on = self._shed = self._oversize = 0\n",
       "        self._received = self._handed_on = self._shed = self._oversize = 0\n        self.archive = None\n"),
      ("            self._shed += 1\n            return False", "            self.archive.record_dropped(1)\n            return False"),
      ("        self.buffer = CaptureBuffer(cfg.buffer_max)\n", "        self.buffer = CaptureBuffer(cfg.buffer_max)\n        self.buffer.archive = archive\n"),
      ("        self._unavailable = 0\n", "        self._unavailable = 0\n        self._dropped = 0\n", "archive.py"),
      ('"buffered": 0, "dropped": 0,', '"buffered": 0, "dropped": self._dropped,', "archive.py"),
      ("    def counters(self)", "    def record_dropped(self, n: int = 1) -> None:\n        with self._state:\n            self._received += n\n            self._dropped += n\n\n    def counters(self)", "archive.py")]),
    ("i2", "handed_on counted on an unavailable answer", "ingester.py",
     [("            self._retry = (batch_id, len(batch))\n            self.log.warn", "            self._retry = (batch_id, len(batch))\n            self.buffer._handed_on += len(batch)\n            self.log.warn")]),
    ("i3", "handed_on not counted when a batch leaves the buffer", "ingester.py",
     [("            self._handed_on += n\n", "            pass\n")]),
    # ---- the buffer ----
    ("b1", "a full buffer grows past its bound instead of counting dropped", "ingester.py",
     [("            if len(self._q) < self.bound:", "            if True:")]),
    ("b2", "a full buffer sheds without counting", "ingester.py",
     [("            self._shed += 1\n            return False", "            return False")]),
    ("b3", "a shed capture is not counted as received", "ingester.py",
     [("            self._received += 1\n            if oversize:", "            if len(self._q) < self.bound:\n                self._received += 1\n            if oversize:")]),
    ("b4", "a batch leaves the buffer although the archive was unavailable", "ingester.py",
     [("            self._retry = (batch_id, len(batch))\n", "            self._retry = (batch_id, len(batch))\n            self.buffer.hand_on(len(batch))\n")]),
    ("b5", "the receive path writes to the archive synchronously", "ingester.py",
     [("        self._buffer.put(capture, oversize)", "        self._buffer._archive.append('sync-1', [{'source': 'x'}])\n        self._buffer.put(capture, oversize)"),
      ("        self.buffer = CaptureBuffer(cfg.buffer_max)\n", "        self.buffer = CaptureBuffer(cfg.buffer_max)\n        self.buffer._archive = archive\n")]),
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
            # an edit is (old, new) in the mutant's file, or (old, new, other_file)
            texts: dict[str, str] = {}
            backups: dict[str, pathlib.Path] = {}
            for e in edits:
                f = e[2] if len(e) == 3 else fname
                if f not in backups:
                    backups[f] = pathlib.Path(tmp) / f"{mid}-{f}"
                    shutil.copy2(SRC / f, backups[f])
                    texts[f] = (SRC / f).read_text()
            try:
                bad = False
                for e in edits:
                    f = e[2] if len(e) == 3 else fname
                    if texts[f].count(e[0]) != 1:
                        print(f"{mid}: pattern not found exactly once ({texts[f].count(e[0])}): {e[0][:60]!r}")
                        survivors.append(mid)
                        bad = True
                        break
                    texts[f] = texts[f].replace(e[0], e[1])
                if bad:
                    continue
                for f, t in texts.items():
                    (SRC / f).write_text(t)
                if any(filecmp.cmp(SRC / f, backups[f], shallow=False) for f in texts):
                    print(f"{mid}: an edit did not change its file")
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
                for f, b in backups.items():
                    shutil.copy2(b, SRC / f)
                    if not filecmp.cmp(SRC / f, b, shallow=False):
                        print(f"{mid}: RESTORE FAILED for {f}")
                        survivors.append(mid)
    rc, _ = run_tests()
    print("restored; control run " + ("passes" if rc == 0 else "FAILS"))
    total = len(todo)
    print(f"{total - len(survivors)} of {total} mutants killed")
    return 1 if survivors or rc != 0 else 0


if __name__ == "__main__":
    sys.exit(main())
