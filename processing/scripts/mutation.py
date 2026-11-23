#!/usr/bin/env python3
"""Mutation check for the observation processing rules.

Each mutant breaks one rule in the source; the tests must then fail. A control run of the unmutated tree
comes first and must pass, so a failure is never a broken invocation. For every mutant the file is compared
with its backup to prove the edit changed it, and it is restored afterwards (and compared again) whatever
happens. Run from processing/:   python3 scripts/mutation.py [mutant ids...]

Needs the dev requirements (pytest, jsonschema).
"""
import filecmp
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "src" / "mecon_processing"

DUP_SQL = ("            \"SELECT 1 FROM receptions WHERE packet_id = ? AND source = ? AND observer_key IS ?\"\n"
           "            \" AND device_observed_at IS ? AND rssi IS ? AND snr IS ? LIMIT 1\",")


def dup_sql(old, new):
    """The duplicate query with one condition made always true (its parameter still consumed)."""
    return (DUP_SQL, DUP_SQL.replace(old, new))


ALWAYS = "(? IS NOT NULL OR 1)"

MUTANTS = [
    # ---- framing and identity (section 3) ----
    ("f1", "TRACE's path byte left out of the identity", "framing.py",
     [("    if p.payload_type == TRACE:", "    if False:")]),
    ("f2", "the route type is part of the identity", "framing.py",
     [("    h.update(bytes([p.payload_type]))", "    h.update(bytes([p.payload_type, p.route_type]))")]),
    ("f3", "a payload over 184 bytes is accepted", "framing.py",
     [("MAX_PAYLOAD_BYTES = 184", "MAX_PAYLOAD_BYTES = 1000")]),
    ("f4", "the reserved hash mode 3 is accepted", "framing.py",
     [("    if hash_mode == 3:\n        return None\n", "    if False:\n        return None\n")]),
    ("f5", "a path over 64 bytes is accepted", "framing.py",
     [("MAX_PATH_BYTES = 64", "MAX_PATH_BYTES = 200")]),
    ("f6", "an empty payload is accepted", "framing.py",
     [("    if payload_len < 1 or payload_len > MAX_PAYLOAD_BYTES:", "    if payload_len < 0 or payload_len > MAX_PAYLOAD_BYTES:")]),
    ("f7", "route type 3 carries no transport codes", "framing.py",
     [("    if route_type in (0, 3):", "    if route_type in (0,):")]),
    ("f8", "the identity is lowercase", "framing.py",
     [("    return h.hexdigest()[:16].upper()", "    return h.hexdigest()[:16]")]),
    ("f9", "the identity is 15 digits", "framing.py",
     [("    return h.hexdigest()[:16].upper()", "    return h.hexdigest()[:15].upper()")]),
    ("f10", "TRACE's path byte is hashed as one byte", "framing.py",
     [('        h.update(p.path_byte.to_bytes(2, "little"))', '        h.update(p.path_byte.to_bytes(1, "little"))')]),
    # ---- the adapters (section 2) ----
    ("a1", "an RSSI of 0 is kept", "adapters.py",
     [("    if rssi == 0:", "    if False:")]),
    ("a2", "the device-time window ahead is widened", "adapters.py",
     [("DEVICE_TIME_AHEAD_S = 60", "DEVICE_TIME_AHEAD_S = 3600")]),
    ("a3", "the device-time floor is lowered", "adapters.py",
     [("DEVICE_TIME_FLOOR = 1735689600", "DEVICE_TIME_FLOOR = 1")]),
    ("a4", "the origin check is case-sensitive", "adapters.py",
     [(r'origin.strip(" \t\r\n").lower() != observer.strip(" \t\r\n").lower()', r'origin.strip(" \t\r\n") != observer.strip(" \t\r\n")')]),
    ("a4b", "origin_id is not trimmed", "adapters.py",
     [(r'and origin.strip(" \t\r\n").lower() != observer.strip(" \t\r\n").lower()', r'and origin.lower() != observer.lower()')]),
    ("a5", "an observer's own transmissions are not filtered", "adapters.py",
     [('    if env.get("direction") == "tx":', "    if False:")]),
    ("a6", "a boolean counts as a number", "adapters.py",
     [("    if isinstance(v, bool):\n        return None\n", "")]),
    ("a7", "a number that is not finite is kept", "adapters.py",
     [("    if isinstance(out, float) and not math.isfinite(out):", "    if False:")]),
    ("a8", "an SNR of 0 reads as null", "adapters.py",
     [("    return Extraction(data=bytes.fromhex(hexs), rssi=rssi, snr=snr,", "    return Extraction(data=bytes.fromhex(hexs), rssi=rssi, snr=snr or None,")]),
    ("a9", "an empty hex string is malformed", "adapters.py",
     [('_HEX = re.compile(r"(?:[0-9a-fA-F]{2})*")', '_HEX = re.compile(r"(?:[0-9a-fA-F]{2})+")')]),
    ("a10", "the device time is not truncated", "adapters.py",
     [("    ts = math.trunc(n)", "    ts = round(n)")]),
    ("a11", "an unknown adapter is read as observer_envelope", "adapters.py",
     [('    raise ValueError(f"unknown adapter {adapter!r}")\n\n\ndef _envelope', "    return _envelope(topic, payload, received_at)\n\n\ndef _envelope")]),
    ("a12", "only the first present of data, raw_data, raw is not required usable (a bad one is passed over)", "adapters.py",
     [('    key = next((k for k in ("data", "raw_data", "raw") if k in env), None)',
       '    key = next((k for k in ("data", "raw_data", "raw") if isinstance(env.get(k), str) and _HEX.fullmatch(env[k])), None)')]),
    ("a13", "the lower-case rssi is preferred over RSSI", "adapters.py",
     [('number(env["RSSI"] if "RSSI" in env else env.get("rssi"))', 'number(env["rssi"] if "rssi" in env else env.get("RSSI"))')]),
    ("a14", "numeric strings are not read", "adapters.py",
     [("    elif isinstance(v, str) and _NUMERIC.fullmatch(v):\n        out = float(v)", "    elif False:\n        out = 0")]),
    # ---- the processor (section 4) ----
    ("p1", "retained is checked before stub", "processor.py",
     [('        if c["stub"]:\n            return "stub", None\n        if c["retained"]:\n            return "retained", None\n',
       '        if c["retained"]:\n            return "retained", None\n        if c["stub"]:\n            return "stub", None\n')]),
    ("p2", "the duplicate rule ignores snr", "store.py", [dup_sql("snr IS ?", ALWAYS)]),
    ("p3", "the duplicate rule ignores rssi", "store.py", [dup_sql("rssi IS ?", ALWAYS)]),
    ("p4", "the duplicate rule ignores the device time value", "store.py", [dup_sql("device_observed_at IS ?", ALWAYS)]),
    ("p5", "the duplicate rule applies without a device time", "processor.py",
     [('        if r["device_observed_at"] is not None and b.has_duplicate(r):', "        if b.has_duplicate(r):")]),
    ("p6", "the duplicate rule ignores the source", "store.py", [dup_sql("source = ?", ALWAYS)]),
    ("p7", "the duplicate rule ignores the observer", "store.py", [dup_sql("observer_key IS ?", ALWAYS)]),
    ("p8", "the packet is seen only after the duplicate check", "processor.py",
     [('        b.see_packet(r["packet_id"], r["packet_type"], r["received_at"])\n'
       '        if r["device_observed_at"] is not None and b.has_duplicate(r):\n            return "skipped", "duplicate_report"\n',
       '        if r["device_observed_at"] is not None and b.has_duplicate(r):\n            return "skipped", "duplicate_report"\n'
       '        b.see_packet(r["packet_id"], r["packet_type"], r["received_at"])\n')]),
    ("p9", "last_seen_at is never raised after the first sight", "store.py",
     [("        if cur.rowcount == 0:", "        if False:")]),
    ("p10", "last_seen_at may be lowered", "store.py",
     [(" WHERE packet_id = ? AND last_seen_at < ?\",", " WHERE packet_id = ?\",") , ("(received_at, packet_id, received_at))", "(received_at, packet_id))")]),
    ("p11", "a packet's first fields are rewritten by a later reception", "store.py",
     [("INSERT OR IGNORE INTO packets", "INSERT OR REPLACE INTO packets")]),
    ("p12", "the batch bound is 5000", "config.py", [("MAX_BATCH = 500", "MAX_BATCH = 5000")]),
    ("p13", "an unexpected error stops the batch instead of failing the capture", "processor.py",
     [("        except Exception as e:  # an unexpected error", "        except KeyError as e:  # an unexpected error")]),
    ("p14", "a capture that already has an outcome is processed again", "processor.py",
     [('                if b.has_outcome(c["capture_id"]):\n                    continue\n', "")]),
    ("p15", "progress is lowered by an older capture", "store.py",
     [("MAX(last_capture_id, excluded.last_capture_id)", "excluded.last_capture_id")]),
    ("p16", "the fault point is before the writes (a crash would prove nothing)", "processor.py",
     [("            if fault is not None:\n                fault()\n", ""),
      ("        done: list[tuple[str, str | None]] = []\n        with self.store.batch() as b:\n",
       "        done: list[tuple[str, str | None]] = []\n        with self.store.batch() as b:\n            if fault is not None:\n                fault()\n")]),
    # ---- the store (atomic batches, idempotence) ----
    ("s1", "progress committed in a separate transaction from the output", "store.py",
     [("(capture_id,))\n\n\ndef fold_hours", '(capture_id,))\n        self._c.execute("COMMIT")\n        self._c.execute("BEGIN IMMEDIATE")\n\n\ndef fold_hours')]),
    ("s2", "the batch's output is committed even when the batch raises", "store.py",
     [('            except BaseException:\n                self._conn.execute("ROLLBACK")\n                raise',
       '            except BaseException:\n                self._conn.execute("COMMIT")\n                raise')]),
    ("s3", "capture_id uniqueness dropped on receptions", "store.py",
     [("    capture_id         INTEGER NOT NULL UNIQUE,", "    capture_id         INTEGER NOT NULL,")]),
    ("s4", "outcomes do not enforce one per capture", "store.py",
     [("    capture_id INTEGER PRIMARY KEY,\n    outcome ", "    capture_id INTEGER,\n    outcome ")]),
    ("s5", "hours fold receptions with no observer", "store.py",
     [('        if r["observer_key"] is None:\n            return  # a reception with no observer is not folded', "        if False:\n            return"),
      ('(r["source"], r["observer_key"], hour_of(r["received_at"]),\n             r["rssi"]', '(r["source"], r["observer_key"] or "", hour_of(r["received_at"]),\n             r["rssi"]')]),
    ("s6", "the rebuild counts snr readings differently from the incremental fold", "store.py",
     [('            h["snr_count"] += 1', '            h["snr_count"] += 0')]),
    ("s7", "the incremental fold counts a null rssi as a reading", "store.py",
     [('r["rssi"] if r["rssi"] is not None else 0.0, int(r["rssi"] is not None),', 'r["rssi"] if r["rssi"] is not None else 0.0, 1,')]),
    ("s8", "the hour is cut at the day", "store.py",
     [('    return received_at[:13] + ":00:00Z"', '    return received_at[:10] + "T00:00:00Z"')]),
    ("s9", "the rebuild leaves stale rows in place", "store.py",
     [('            b._c.execute("DELETE FROM hours")\n', "")]),
    ("s10", "the stored aggregate drops a reception's snr", "store.py",
     [('r["snr"] if r["snr"] is not None else 0.0, int(r["snr"] is not None)))', '0.0, int(r["snr"] is not None)))')]),
    # ---- configuration and counters (section 6) ----
    ("c1", "an unknown adapter in the configuration is not refused", "config.py",
     [("        if s.get(\"adapter\") not in ADAPTERS:", "        if False:")]),
    ("c2", "pending is read from before the progress mark", "processor.py",
     [("        pending, oldest = source.pending(progress)", "        pending, oldest = source.pending(0)")]),
    ("c3", "a reception is counted twice", "processor.py",
     [("                    self._receptions += 1", "                    self._receptions += 2")]),
    ("c4", "processed does not include skipped captures", "processor.py",
     [('"processed": receptions + sum(skipped.values())', '"processed": receptions')]),
    ("c5", "a batch is counted as it is processed, before its commit", "processor.py",
     [("                done.append((outcome, reason))\n", '                done.append((outcome, reason))\n                self._skipped[reason or "stub"] += outcome == "skipped"\n                self._receptions += outcome == "reception"\n'),
      ("            for outcome, reason in done:\n                if outcome", "            for outcome, reason in []:\n                if outcome")]),
    ("c6", "the oldest pending lag is measured from the newest capture", "processor.py",
     [("        pending, oldest = source.pending(progress)", "        pending, oldest = source.pending(progress)\n        oldest = None if oldest is None else max(oldest, '2026-01-01T00:00:03.000Z')")]),
]


def run_tests():
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    try:
        p = subprocess.run([sys.executable, "-m", "pytest", "-q", "-x", "-p", "no:cacheprovider"],
                           cwd=ROOT, capture_output=True, text=True, env=env, timeout=180)
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
