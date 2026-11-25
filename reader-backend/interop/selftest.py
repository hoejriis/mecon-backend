"""Checks the driver without any core: it runs the driver against the in-repo stub core and facade, with the ops
layer served by the real `ops_agent.py` over a unix socket. It proves the driver's wiring (ops, redaction,
NA, the revocation case), not any core. Run: `python interop/selftest.py [--mutate no-feed|no-degrade|diverge]`.
The mutations make the driver's verdict change: `no-feed` signs out without a feed item (the revocation case
must FAIL), `no-degrade` leaves out core_degraded (lookup-17 must be NA), `diverge` lists a divergence the stub
does not have (lookup-01 must FAIL, never pass).
"""
from __future__ import annotations

import asyncio
import os
import pathlib
import secrets
import subprocess
import sys
import tempfile
import threading

HERE = pathlib.Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent / "src"), str(HERE.parent / "tests")]

from null_core import NullCore  # noqa: E402
from lookup_replay import LOOKUP  # noqa: E402
from mecon_reader_backend import FacadeConfig, HttpSessionLookup, create_app  # noqa: E402
from stub_core import StubCore, serve, world_from_lookup_description  # noqa: E402
import ops_agent  # noqa: E402
from core_ops import NotApplicable  # noqa: E402


class StubOps:
    def __init__(self, loop, stub: StubCore, mutate: str | None):
        self.loop, self.stub, self.world, self.mutate = loop, stub, stub.world, mutate
        self.known_divergences = ([{"case": "lookup-01", "pointer": "/display_name", "reason": "mutation"}]
                                  if mutate == "diverge" else [])
        if mutate == "no-degrade":
            self.core_degraded = None  # absent: the case is not applicable

    def on_loop(self, fn):
        async def go():
            return fn()
        return asyncio.run_coroutine_threadsafe(go(), self.loop).result(10)

    def setup(self):
        return None

    def issue_session(self, user):
        return self.on_loop(lambda: self.world.mint_session(user).credential)

    def _session(self, cred):
        return self.world.sessions[cred]

    def expire_session(self, credential):
        from datetime import timedelta
        from mecon_reader_backend.fakes.world import now
        self.on_loop(lambda: setattr(self._session(credential), "expires_at", now() - timedelta(seconds=1)))

    def revoke_session(self, credential):
        if self.mutate == "no-feed":
            return self.on_loop(lambda: setattr(self._session(credential), "revoked", True))
        self.on_loop(lambda: self.world.revoke(self._session(credential)))

    def csrf_for(self, credential):
        return self.on_loop(lambda: self.world.csrf_for(self._session(credential)))

    def core_degraded(self):
        self.on_loop(lambda: setattr(self.stub.lookup, "unavailable", True))

    def core_recovered(self):
        self.on_loop(lambda: setattr(self.stub.lookup, "unavailable", False))


async def main() -> int:
    mutate = sys.argv[sys.argv.index("--mutate") + 1] if "--mutate" in sys.argv else None
    loop = asyncio.get_running_loop()
    world = world_from_lookup_description(LOOKUP.worlds["worlds"]["basic"])
    stub = StubCore(world)
    with tempfile.TemporaryDirectory() as td:
        token = pathlib.Path(td) / "service_token"
        token.write_text(stub.token + "\n")
        os.chmod(token, 0o600)
        sock = str(pathlib.Path(td) / "ops.sock")
        ops = StubOps(loop, stub, mutate)
        srv = ops_agent.Server(sock, ops_agent.Handler)
        srv.ops = ops
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        async with serve(stub) as base, serve(create_app(
                HttpSessionLookup(base, token, timeout_s=2.0), NullCore(),
                FacadeConfig(lookup_cache_s=30.0, feed_retry_s=0.5, cookie_secure=False))) as facade:
            env = {**os.environ, "CORE_LOOKUP_URL": base, "SERVICE_TOKEN_FILE": str(token), "FACADE_URL": facade,
                   "OPS_SOCKET": sock, "PYTHONPATH": os.pathsep.join([str(HERE), str(HERE.parent / "src"), str(HERE.parent / "tests")])}
            proc = await asyncio.create_subprocess_exec(sys.executable, str(HERE / "driver.py"), env=env)
            rc = await proc.wait()
        srv.shutdown()
    print(f"selftest: driver exit {rc} (mutation: {mutate})")
    return rc


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
