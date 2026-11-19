"""The hold over TLS: the certificate is verified against the configured CA, and the token is never sent to a
server whose certificate does not verify. Uses a synthetic CA made with openssl (skipped where it is absent)."""

import shutil
import ssl
import subprocess

import pytest

from fakes.fake_hold_server import TOKEN, FakeHoldServer
from hold_rig import HoldRig

pytestmark = pytest.mark.skipif(shutil.which("openssl") is None, reason="needs openssl to make a synthetic CA")


def make_cert(d, name):
    key, crt = d / f"{name}.key", d / f"{name}.pem"
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key), "-out", str(crt), "-days", "2",
         "-subj", "/CN=hold-test", "-addext", "subjectAltName=IP:127.0.0.1"],
        check=True, capture_output=True,
    )
    return key, crt


def server_ctx(key, crt):
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(str(crt), str(key))
    return ctx


def rig(tmp_path, server, ca):
    r = HoldRig(tmp_path, server=server, ca_file=str(ca))
    return r


def test_wss_connects_when_the_certificate_verifies(tmp_path):
    key, crt = make_cert(tmp_path, "good")
    server = FakeHoldServer(ssl_context=server_ctx(key, crt))
    r = rig(tmp_path, server, crt)
    try:
        assert r.cfg.hold.ws_url.startswith("wss://") and not r.cfg.hold.insecure_allow_plain
        conn = r.up()
        assert conn.headers["authorization"] == f"Bearer {TOKEN}"
    finally:
        r.close()
        server.shutdown()


def test_an_unverified_certificate_is_a_tls_failure_and_the_token_is_never_sent(tmp_path):
    key, crt = make_cert(tmp_path, "server")
    _, other = make_cert(tmp_path, "other")
    server = FakeHoldServer(ssl_context=server_ctx(key, crt))
    r = rig(tmp_path, server, other)  # trusts a different CA
    try:
        r.wait(lambda: r.m("hold_connect_attempts_total", "tls") >= 1)
        assert r.bridge.hold_stop is None  # retried on the backoff, never trusted
        assert server.conns == []  # no handshake completed, so no Authorization header reached the server
        assert TOKEN not in r.logbuf.getvalue()
    finally:
        r.close()
        server.shutdown()
