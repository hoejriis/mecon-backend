import base64
import json

from mecon_processing.processor import Processor
from mecon_processing.store import Store

T0 = "2026-01-01T00:00:00.000Z"


class InjectedFault(Exception):
    pass


class ListSource:
    """An in-memory input: internal captures, read in capture_id order."""

    def __init__(self, captures=()):
        self.captures = sorted(captures, key=lambda c: c["capture_id"])

    def read(self, after_id, limit):
        return [c for c in self.captures if c["capture_id"] > after_id][:limit]

    def pending(self, after_id):
        p = [c for c in self.captures if c["capture_id"] > after_id]
        return len(p), (min(c["received_at"] for c in p) if p else None)


def packet(route=1, ptype=4, payload=b"\x01\x02\x03", path=b"", hash_mode=0, transport=b"\x00\x00\x00\x00", hops=None):
    """Packet bytes: header, transport codes (route 0 and 3), path byte, path, payload."""
    n = len(path) // (hash_mode + 1) if hops is None else hops
    out = bytes([route | (ptype << 2)])
    if route in (0, 3):
        out += transport
    return out + bytes([(hash_mode << 6) | n]) + path + payload


def envelope(**kw):
    return json.dumps(kw).encode()


def cap(cid, payload, *, source="own-broker", topic="meshcore/AB12/obs-1/packets", at=T0, retained=False, stub=False):
    return {"capture_id": cid, "source": source, "topic": topic, "payload": None if stub else payload,
            "stub": stub, "retained": retained, "received_at": at}


def b64(b):
    return base64.b64encode(b).decode()


SOURCES = {"own-broker": "observer_envelope", "second-broker": "observer_envelope", "open-feed": "raw_hex"}


def make(tmp_path, sources=None, name="p.sqlite3", **kw):
    store = Store(str(tmp_path / name))
    return store, Processor(store, sources or SOURCES, **kw)


def env_cap(cid, hexs, **kw):
    """A capture from the envelope source; envelope fields come from kw entries starting with env_."""
    env = {"data": hexs}
    env.update({k[4:]: v for k, v in kw.items() if k.startswith("env_")})
    rest = {k: v for k, v in kw.items() if not k.startswith("env_")}
    return cap(cid, json.dumps(env).encode(), **rest)


def boom_after_writes(store, written=1):
    """A fault for the point between the writes and the commit; it first checks the batch's writes are there."""
    def fault():
        assert len(store.outcomes()) >= written, "the fault point must come after the batch's writes"
        raise InjectedFault("injected before commit")
    return fault
