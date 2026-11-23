"""The processor (contract sections 4 to 6): pending captures in capture_id order, in batches of at most 500, one
outcome per capture, one transaction per batch."""

from __future__ import annotations

import sqlite3
import threading
import time
from typing import Any, Callable, Protocol

from .adapters import epoch_ms, extract, observer_key
from .config import MAX_BATCH, ConfigError, validate_sources
from .framing import packet_id, packet_type_name_of, parse_packet
from .logutil import Log
from .store import Store

REASONS = ("retained", "stub", "not_a_packet", "malformed", "origin_mismatch", "unparseable", "duplicate_report", "failed")


class Source(Protocol):
    def read(self, after_id: int, limit: int) -> list[dict[str, Any]]: ...
    def pending(self, after_id: int) -> tuple[int, str | None]: ...


class Processor:
    def __init__(self, store: Store, sources: dict[str, str], *, batch_max: int = MAX_BATCH,
                 clock: Callable[[], float] = time.time, log: Log | None = None) -> None:
        problems = validate_sources({n: {"adapter": a} for n, a in sources.items()})
        if problems:
            raise ConfigError(problems)
        if not 1 <= batch_max <= MAX_BATCH:
            raise ValueError(f"batch_max must be from 1 to {MAX_BATCH}")
        self.store = store
        self.sources = dict(sources)
        self.batch_max = batch_max
        self._clock = clock
        self._log = log or Log(level="warn")
        self._lock = threading.Lock()
        self._receptions = 0
        self._skipped = {r: 0 for r in REASONS}
        self._progress = store.progress()
        self.blocked_on: str | None = None  # a source with no adapter that processing has stopped at

    # ---- one capture ----------------------------------------------------------------------

    def _analyse(self, c: dict[str, Any]) -> tuple[str | None, dict[str, Any] | None]:
        """(skip reason, None) or (None, the reception's fields and its packet). Pure: touches no store."""
        if c["stub"]:
            return "stub", None
        if c["retained"]:
            return "retained", None
        adapter = self.sources[c["source"]]
        x = extract(adapter, c["topic"], c["payload"], c["received_at"])
        if x.skip:
            return x.skip, None
        parsed = parse_packet(x.data)
        if parsed is None:
            return "unparseable", None
        return None, {"packet_id": packet_id(parsed), "packet_type": packet_type_name_of(parsed),
                      "source": c["source"], "observer_key": observer_key(adapter, c["topic"]),
                      "received_at": c["received_at"], "device_observed_at": x.device_observed_at,
                      "rssi": x.rssi, "snr": x.snr, "hop_count": parsed.hop_count, "route_type": parsed.route_type,
                      "capture_id": c["capture_id"]}

    def _process_one(self, b: Any, c: dict[str, Any]) -> tuple[str, str | None]:
        try:
            reason, r = self._analyse(c)
        except Exception as e:  # an unexpected error: the capture is failed, and not retried
            self._log.warn("capture_failed", capture_id=c.get("capture_id"), error=type(e).__name__)
            return "skipped", "failed"
        if r is None:
            return "skipped", reason
        # The packet is recorded as seen before the duplicate check: a repeated report still moves last_seen_at.
        b.see_packet(r["packet_id"], r["packet_type"], r["received_at"])
        if r["device_observed_at"] is not None and b.has_duplicate(r):
            return "skipped", "duplicate_report"
        b.add_reception(r)
        return "reception", None

    # ---- batches --------------------------------------------------------------------------

    def process_batch(self, captures: list[dict[str, Any]], fault: Callable[[], None] | None = None) -> int:
        """Process captures (capture_id order) in one transaction. `fault`, when given, is called after every
        write and before the commit (a test's injected failure). A capture that already has an outcome is
        left alone. Returns how many captures got an outcome now."""
        if len(captures) > self.batch_max:
            raise ValueError(f"a batch holds at most {self.batch_max} captures")
        # A capture from a source this processor has no adapter for is a configuration gap, not bad data: stop
        # before it and leave it pending, so fixing the configuration recovers it (README section 4).
        for i, c in enumerate(captures):
            if c["source"] not in self.sources:
                if self.blocked_on != c["source"]:
                    self._log.error("source_not_configured", source=c["source"], capture_id=c["capture_id"])
                self.blocked_on = c["source"]
                captures = captures[:i]
                break
        else:
            self.blocked_on = None
        try:
            return self._commit(captures, fault)
        except (sqlite3.IntegrityError, sqlite3.DataError) as e:
            # Data that the store refuses: one capture is at fault, not the batch. Re-run it capture by capture
            # and record the one the store refuses as failed. An OperationalError (storage) propagates: retried.
            if len(captures) <= 1:
                return self._commit_failed(captures, e)
            done = 0
            for c in captures:
                try:
                    done += self._commit([c], fault)
                except (sqlite3.IntegrityError, sqlite3.DataError) as e1:
                    done += self._commit_failed([c], e1)
            return done

    def _commit_failed(self, captures: list[dict[str, Any]], e: Exception) -> int:
        if not captures:
            return 0
        c = captures[0]
        self._log.warn("capture_failed", capture_id=c["capture_id"], error=type(e).__name__)
        with self.store.batch() as b:
            if not b.has_outcome(c["capture_id"]):
                b.add_outcome(c["capture_id"], "skipped", "failed")
            b.set_progress(c["capture_id"])
        with self._lock:
            self._skipped["failed"] += 1
            self._progress = max(self._progress, c["capture_id"])
        return 1

    def _commit(self, captures: list[dict[str, Any]], fault: Callable[[], None] | None) -> int:
        done: list[tuple[str, str | None]] = []
        with self.store.batch() as b:
            for c in captures:
                if b.has_outcome(c["capture_id"]):
                    continue
                outcome, reason = self._process_one(b, c)
                b.add_outcome(c["capture_id"], outcome, reason)
                done.append((outcome, reason))
            if captures:
                b.set_progress(captures[-1]["capture_id"])
            if fault is not None:
                fault()
        with self._lock:  # counted only once the batch has committed
            for outcome, reason in done:
                if outcome == "reception":
                    self._receptions += 1
                else:
                    self._skipped[reason] += 1
            if captures:
                self._progress = max(self._progress, captures[-1]["capture_id"])
        return len(done)

    def run_pending(self, source: Source, limit: int | None = None,
                    fault: Callable[[], None] | None = None) -> int:
        """Take up to `limit` (and at most batch_max) pending captures and process them as one batch."""
        n = self.batch_max if limit is None else min(limit, self.batch_max)
        captures = source.read(self.store.progress(), n)
        return self.process_batch(captures, fault) if captures else 0

    def drain(self, source: Source) -> int:
        total = 0
        while True:
            n = len(batch := source.read(self.store.progress(), self.batch_max))
            if n == 0:
                return total
            total += self.process_batch(batch)
            if self.blocked_on is not None:
                return total  # stopped at an unconfigured source: what follows waits for the configuration

    # ---- counters -------------------------------------------------------------------------

    def counters(self, source: Source) -> dict[str, Any]:
        """The counters document (counters.schema.json). Totals since this processor started; pending and
        oldest_pending_ms are read from the input side."""
        with self._lock:
            receptions, skipped, progress = self._receptions, dict(self._skipped), self._progress
        pending, oldest = source.pending(progress)
        lag = None
        if pending and oldest is not None:
            lag = max(0, int(self._clock() * 1000) - epoch_ms(oldest))
        return {"processed": receptions + sum(skipped.values()), "receptions": receptions, "skipped": skipped,
                "pending": pending, "oldest_pending_ms": lag}
