import datetime as dt

from mecon_capture import config as C
from mecon_capture.archive import Archive
from mecon_capture.ingester import Ingester
from mecon_capture.logutil import Log
from fakes.fake_transport import FakeTransport


class SilentStream:
    def __init__(self):
        self.lines = []

    def write(self, s):
        self.lines.append(s)

    def flush(self):
        pass


class Clock:
    def __init__(self, t="2026-01-01T00:00:00.000Z"):
        self.set(t)

    def set(self, iso):
        self.t = dt.datetime.strptime(iso, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=dt.timezone.utc)

    def advance_ms(self, ms):
        self.t += dt.timedelta(milliseconds=ms)

    def __call__(self):
        return self.t


def make_cfg(profiles, tmp_path, **ing):
    raw = {"archive": {"path": str(tmp_path / "arch.sqlite3")}, "ingester": {"instance_tag": "t1", **ing},
           "profile": profiles}
    return C.parse(raw)


def make_ingester(profiles, tmp_path, clock=None, **ing):
    cfg = make_cfg(profiles, tmp_path, **ing)
    archive = Archive(cfg.archive_path, cfg.max_payload_bytes)
    transports = {}

    def factory(p):
        transports[p.name] = FakeTransport()
        return transports[p.name]

    stream = SilentStream()
    ig = Ingester(cfg, archive, factory, clock=clock or Clock(), log=Log(stream=stream))
    return ig, archive, transports, stream
